#!/usr/bin/env node
/**
 * claude-relay-mcp-server
 *
 * MCP channel server for inter-session communication between Claude Code instances.
 * Session A sends a task via HTTP POST, Session B (running with --channels) receives
 * it as a <channel> notification, processes it, and replies via the relay_reply tool.
 * Session A retrieves the result via HTTP GET.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

// ── Configuration ──────────────────────────────────────────────────

const HTTP_PORT = parseInt(process.env.RELAY_PORT || "8788", 10);
const RELAY_BIND = process.env.RELAY_BIND || "0.0.0.0";
const RELAY_URL = process.env.RELAY_URL || `http://127.0.0.1:${HTTP_PORT}`;
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const SESSION_NAME = process.env.RELAY_SESSION_NAME || `session-${randomBytes(3).toString("hex")}`;
const TASK_TTL_MS = parseInt(process.env.RELAY_TASK_TTL_HOURS || "8", 10) * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MACHINE_HEARTBEAT_MS = 30 * 1000; // 30 seconds stale threshold

// ── Task Store ─────────────────────────────────────────────────────

interface Task {
  id: string;
  message: string;
  status: "pending" | "done" | "error" | "awaiting_permission";
  result?: string;
  sender?: string;
  to?: string;
  createdAt: number;
  lastAccessed: number;
  permissionRequest?: PermissionRequest;
}

interface PermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  receivedAt: number;
}

const tasks = new Map<string, Task>();

// ── Chat Store ────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  from: string;
  message: string;
  room: string;
  replyTo?: string; // id of message being replied to
  createdAt: number;
}

const chatMessages: ChatMessage[] = [];
const MAX_CHAT_HISTORY = 200;

function addChatMessage(from: string, message: string, room: string, replyTo?: string): ChatMessage {
  const msg: ChatMessage = {
    id: generateId(),
    from,
    message,
    room,
    replyTo,
    createdAt: Date.now(),
  };
  chatMessages.push(msg);
  if (chatMessages.length > MAX_CHAT_HISTORY) {
    chatMessages.splice(0, chatMessages.length - MAX_CHAT_HISTORY);
  }
  return msg;
}

function getChatHistory(room: string, limit = 50): ChatMessage[] {
  return chatMessages
    .filter((m) => m.room === room)
    .slice(-limit);
}

// ── SSE Subscribers ───────────────────────────────────────────────

interface SSESubscriber {
  res: ServerResponse;
  senderId?: string;
}

const sseSubscribers = new Set<SSESubscriber>();

// ── Observer Stream (firehose of ALL events) ─────────────────────

interface Observer {
  res: ServerResponse;
}

const observers = new Set<Observer>();

function broadcastToObservers(event: {
  type: "task_created" | "task_completed" | "chat" | "machine_online" | "machine_offline";
  [key: string]: unknown;
}): void {
  const data = JSON.stringify({ ...event, timestamp: Date.now() });
  for (const obs of observers) {
    try {
      obs.res.write(`data: ${data}\n\n`);
    } catch {
      observers.delete(obs);
    }
  }
}

function broadcastSSE(taskId: string, message: string, sender?: string, to?: string): void {
  const data = JSON.stringify({ task_id: taskId, message, sender, to });
  for (const sub of sseSubscribers) {
    // If "to" is specified, only send to that subscriber; otherwise broadcast to all
    if (to && sub.senderId && sub.senderId !== to) continue;
    // Never echo back to sender (self-dedup)
    if (sender && sub.senderId && sub.senderId === sender) continue;
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}

function broadcastChat(msg: ChatMessage): void {
  const data = JSON.stringify({ type: "chat", ...msg });
  for (const sub of sseSubscribers) {
    // Don't echo back to sender
    if (sub.senderId === msg.from) continue;
    try {
      sub.res.write(`data: ${data}\n\n`);
    } catch {
      sseSubscribers.delete(sub);
    }
  }
}

function generateId(): string {
  return randomBytes(6).toString("hex");
}

function cleanupExpiredTasks(): void {
  const now = Date.now();
  for (const [id, task] of tasks) {
    // Use lastAccessed for TTL — polling extends lifetime
    const age = now - task.lastAccessed;
    if (age > TASK_TTL_MS) {
      console.error(`claude-relay: task ${id} expired (age: ${Math.round(age / 60000)}min)`);
      tasks.delete(id);
    }
  }
}

// Periodic cleanup
setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS);

// ── Auth ──────────────────────────────────────────────────────────

function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!RELAY_TOKEN) return true; // no token configured = open
  const auth = req.headers.authorization;
  if (auth === `Bearer ${RELAY_TOKEN}`) return true;
  // Also accept token as query param (for EventSource which can't set headers)
  const url = new URL(req.url || "/", `http://localhost:${HTTP_PORT}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken === RELAY_TOKEN) return true;
  jsonResponse(res, 401, { error: "Unauthorized — invalid or missing token" });
  return false;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (RELAY_TOKEN) headers["Authorization"] = `Bearer ${RELAY_TOKEN}`;
  return headers;
}

// ── Machine Registry ──────────────────────────────────────────────

interface Machine {
  name: string;
  lastSeen: number;
  mode: "host" | "client";
  ip?: string;
}

const machines = new Map<string, Machine>();

function registerMachine(name: string, mode: "host" | "client", ip?: string): void {
  machines.set(name, { name, lastSeen: Date.now(), mode, ip });
}

function getMachineList(): Array<Machine & { online: boolean }> {
  const now = Date.now();
  return Array.from(machines.values()).map((m) => ({
    ...m,
    online: now - m.lastSeen < MACHINE_HEARTBEAT_MS * 3,
    lastSeen: m.lastSeen,
  }));
}

// ── MCP Server ─────────────────────────────────────────────────────

const server = new Server(
  { name: "claude-relay", version: "1.0.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "Messages arrive as <channel source=\"claude-relay\"> tags.",
      "Each message contains a task from another Claude Code session.",
      "After completing the task, call the relay_reply tool with the task_id and your result.",
      "Always include the task_id in your reply so the requesting session can retrieve it.",
      "If you need permission to use a tool, the relay will forward the permission request to the sending session.",
    ].join(" "),
  }
);

// ── Permission Request Handler ─────────────────────────────────────

// Track pending permission requests (keyed by request_id)
const pendingPermissions = new Map<string, {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  receivedAt: number;
  taskId?: string; // link to the task that triggered it
}>();

// Find the most recently created pending task — likely the one waiting for permission
function findActiveTask(): Task | undefined {
  let latest: Task | undefined;
  for (const task of tasks.values()) {
    if (task.status === "pending" && (!latest || task.createdAt > latest.createdAt)) {
      latest = task;
    }
  }
  return latest;
}

// Listen for permission_request notifications from Claude Code
// The SDK schema for this is experimental, so we use a custom Zod-like approach
import { z } from "zod";

const PermissionRequestNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

server.setNotificationHandler(PermissionRequestNotificationSchema, async ({ params }) => {
  const activeTask = findActiveTask();

  const permReq = {
    requestId: params.request_id,
    toolName: params.tool_name,
    description: params.description,
    inputPreview: params.input_preview,
    receivedAt: Date.now(),
    taskId: activeTask?.id,
  };

  pendingPermissions.set(params.request_id, permReq);

  // Update the task status to awaiting_permission
  if (activeTask) {
    activeTask.status = "awaiting_permission";
    activeTask.permissionRequest = {
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
      receivedAt: Date.now(),
    };
  }

  console.error(
    `claude-relay: permission requested — ${params.tool_name}: ${params.description} (id: ${params.request_id}, task: ${activeTask?.id || "unknown"})`
  );

  // Broadcast to SSE subscribers and observers
  broadcastSSE(
    activeTask?.id || "unknown",
    `Permission needed: ${params.tool_name} — ${params.description}. Reply with relay_respond_permission(request_id="${params.request_id}", allow=true/false)`,
    "relay-system",
    activeTask?.sender
  );

  broadcastToObservers({
    type: "permission_request" as any,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
    task_id: activeTask?.id,
  });
});

// ── Tools ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "relay_send_task",
      description: [
        "Send a task to another Claude Code session via the relay.",
        "Returns a task ID that can be used with relay_check_task to get the result.",
        "The receiving session will process the task and reply when done.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The task description or command for the other session",
          },
          sender: {
            type: "string",
            description: "Optional sender identifier (e.g. 'pipecat', 'session-a')",
          },
          to: {
            type: "string",
            description: "Optional recipient session name. If set, only that session receives the task. If omitted, broadcasts to all.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "relay_check_task",
      description: [
        "Check the status and result of a previously sent task.",
        "Returns the task status (pending/done/error) and result if available.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "The task ID returned by relay_send_task",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "relay_reply",
      description: [
        "Report the result of a task back to the requesting session.",
        "Call this after completing work requested via a channel message.",
        "The requesting session will retrieve the result via relay_check_task.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: {
            type: "string",
            description: "The task ID from the channel message",
          },
          result: {
            type: "string",
            description: "The result or summary of the completed work",
          },
          status: {
            type: "string",
            enum: ["done", "error"],
            description: "Whether the task completed successfully or with an error",
          },
        },
        required: ["task_id", "result"],
      },
    },
    {
      name: "relay_list_machines",
      description: [
        "List all machines registered with the relay.",
        "Shows machine name, mode (host/client), online status, and last seen time.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "relay_chat",
      description: [
        "Send a chat message to all connected agents in a room.",
        "Unlike relay_send_task, this is for group conversation — no response is expected.",
        "All agents in the room see the message. Default room is 'general'.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The chat message to send",
          },
          room: {
            type: "string",
            description: "Chat room name (default: 'general')",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "relay_respond_permission",
      description: [
        "Respond to a permission request from the worker session.",
        "When a worker session needs permission to use a tool (e.g. Bash, Write),",
        "it sends a permission request. Use this tool to allow or deny it.",
        "Check relay_check_task — if status is 'awaiting_permission', the permission_request field shows what's pending.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          request_id: {
            type: "string",
            description: "The 5-letter permission request ID",
          },
          allow: {
            type: "boolean",
            description: "true to allow the tool use, false to deny",
          },
        },
        required: ["request_id", "allow"],
      },
    },
    {
      name: "relay_chat_history",
      description: [
        "Get recent chat history for a room.",
        "Returns the last N messages from the specified room.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          room: {
            type: "string",
            description: "Chat room name (default: 'general')",
          },
          limit: {
            type: "number",
            description: "Number of recent messages to return (default: 50)",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── relay_send_task: POST to HTTP endpoint ──
  if (name === "relay_send_task") {
    const { message, sender, to } = args as { message: string; sender?: string; to?: string };
    const effectiveSender = sender || SESSION_NAME;
    try {
      const res = await fetch(`${RELAY_URL}/task`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message, sender: effectiveSender, to }),
      });
      const data = await res.json() as { id?: string; status?: string; error?: string };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Task sent. ID: ${data.id}, status: ${data.status}. Use relay_check_task with this ID to get the result.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay at ${RELAY_URL}. Is the worker session running? ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── relay_check_task: GET from HTTP endpoint ──
  if (name === "relay_check_task") {
    const { task_id } = args as { task_id: string };
    try {
      const res = await fetch(`${RELAY_URL}/task/${task_id}`, {
        headers: authHeaders(),
      });
      const data = await res.json() as { id?: string; status?: string; message?: string; result?: string | null; error?: string };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay at ${RELAY_URL}. ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── relay_reply: PUT to HTTP endpoint (works for both host and client) ──
  if (name === "relay_reply") {
    const { task_id, result, status } = args as {
      task_id: string;
      result: string;
      status?: "done" | "error";
    };

    try {
      const res = await fetch(`${RELAY_URL}/task/${task_id}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ result, status: status || "done" }),
      });
      const data = await res.json() as { id?: string; status?: string; error?: string };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Task ${task_id} marked as ${data.status}. Result stored for retrieval.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay at ${RELAY_URL}. ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── relay_list_machines: GET from HTTP endpoint ──
  if (name === "relay_list_machines") {
    try {
      const res = await fetch(`${RELAY_URL}/machines`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay at ${RELAY_URL}. ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── relay_chat: POST to HTTP endpoint ──
  if (name === "relay_chat") {
    const { message, room, reply_to } = args as {
      message: string;
      room?: string;
      reply_to?: string;
    };
    try {
      const res = await fetch(`${RELAY_URL}/chat`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          from: SESSION_NAME,
          message,
          room: room || "general",
          reply_to,
        }),
      });
      const data = await res.json() as { id?: string; error?: string };
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Message sent (id: ${data.id})` }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay. ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  // ── relay_respond_permission: send permission verdict ──
  if (name === "relay_respond_permission") {
    const { request_id, allow } = args as { request_id: string; allow: boolean };

    const perm = pendingPermissions.get(request_id);
    if (!perm) {
      // Try sending via HTTP to the host (in case we're a client)
      try {
        const res = await fetch(`${RELAY_URL}/permission`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ request_id, allow }),
        });
        const data = await res.json() as { ok?: boolean; error?: string };
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Permission ${allow ? "granted" : "denied"} for request ${request_id}.` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Permission request "${request_id}" not found locally or remotely.` }],
          isError: true,
        };
      }
    }

    // Send permission verdict back to Claude Code via channel notification
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: request_id.toLowerCase(),
        behavior: allow ? "allow" : "deny",
      },
    });

    // Update task status back to pending
    if (perm.taskId) {
      const task = tasks.get(perm.taskId);
      if (task) {
        task.status = "pending";
        task.permissionRequest = undefined;
      }
    }

    pendingPermissions.delete(request_id);
    console.error(`claude-relay: permission ${allow ? "granted" : "denied"} for ${perm.toolName} (${request_id})`);

    return {
      content: [{ type: "text", text: `Permission ${allow ? "granted" : "denied"} for ${perm.toolName} (${request_id}).` }],
    };
  }

  // ── relay_chat_history: GET from HTTP endpoint ──
  if (name === "relay_chat_history") {
    const { room, limit } = args as { room?: string; limit?: number };
    try {
      const params = new URLSearchParams({
        room: room || "general",
        limit: String(limit || 50),
      });
      const res = await fetch(`${RELAY_URL}/chat?${params}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error connecting to relay. ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: "text", text: `Error: Unknown tool "${name}"` }],
    isError: true,
  };
});

// ── HTTP Server ────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${HTTP_PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end();
    return;
  }

  // Add CORS headers to all responses
  res.setHeader("Access-Control-Allow-Origin", "*");

  // GET / — health check (no auth required)
  if (req.method === "GET" && url.pathname === "/") {
    jsonResponse(res, 200, {
      name: "claude-relay",
      version: "2.0.0",
      session_name: SESSION_NAME,
      tasks_count: tasks.size,
      sse_subscribers: sseSubscribers.size,
      auth_required: !!RELAY_TOKEN,
    });
    return;
  }

  // All other endpoints require auth
  if (!checkAuth(req, res)) return;

  // POST /task — create a new task and push to session B
  if (req.method === "POST" && url.pathname === "/task") {
    try {
      const body = await readBody(req);
      let message: string;
      let sender: string | undefined;
      let to: string | undefined;

      // Accept both plain text and JSON
      try {
        const json = JSON.parse(body);
        message = json.message || body;
        sender = json.sender;
        to = json.to;
      } catch {
        message = body;
      }

      if (!message.trim()) {
        jsonResponse(res, 400, { error: "Empty message" });
        return;
      }

      const id = generateId();
      const now = Date.now();
      const task: Task = {
        id,
        message,
        sender,
        to,
        status: "pending",
        createdAt: now,
        lastAccessed: now,
      };
      tasks.set(id, task);

      // Push notification to the local Claude Code session (host mode)
      // Only if: (a) no "to" or "to" matches host, AND (b) sender is NOT the host
      const hostIsTarget = !to || to === SESSION_NAME;
      const senderIsHost = sender === SESSION_NAME;
      if (hostIsTarget && !senderIsHost) {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: message,
            meta: {
              task_id: id,
              ...(sender ? { sender } : {}),
            },
          },
        });
      }

      // Broadcast to SSE subscribers (filtered by "to" if specified)
      broadcastSSE(id, message, sender, to);

      // Notify observers
      broadcastToObservers({
        type: "task_created",
        id,
        message,
        sender,
        to,
      });

      jsonResponse(res, 201, { id, status: "pending" });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error("POST /task error:", errorMessage);
      jsonResponse(res, 500, { error: errorMessage });
    }
    return;
  }

  // PUT /task/:id — update task result (used by relay_reply from any session)
  const taskPutMatch = url.pathname.match(/^\/task\/([a-f0-9]+)$/);
  if (req.method === "PUT" && taskPutMatch) {
    try {
      const body = await readBody(req);
      const { result, status } = JSON.parse(body) as { result: string; status: string };
      const task = tasks.get(taskPutMatch[1]);
      if (!task) {
        jsonResponse(res, 404, { error: "Task not found or expired" });
        return;
      }
      task.status = (status as "done" | "error") || "done";
      task.result = result;

      // Push completion notification ONLY to the original sender
      const completionMsg = `Task ${task.id} completed: ${result}`;
      const completionMeta = {
        task_id: task.id,
        type: "task_completed",
        original_message: task.message,
      };

      // Check if sender is an SSE subscriber
      const senderIsSSE = Array.from(sseSubscribers).some(
        (sub) => sub.senderId === task.sender
      );

      if (senderIsSSE) {
        // Sender is a remote SSE client — notify via SSE
        broadcastSSE(task.id, completionMsg, "relay-system", task.sender);
      } else {
        // Sender is local (host) or unknown — notify via local channel
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: completionMsg, meta: completionMeta },
        });
      }

      // Notify observers
      broadcastToObservers({
        type: "task_completed",
        id: task.id,
        status: task.status,
        result: task.result,
        sender: task.sender,
        originalMessage: task.message,
      });

      jsonResponse(res, 200, { id: task.id, status: task.status });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: errorMessage });
    }
    return;
  }

  // GET /task/:id — check task status and retrieve result
  const taskMatch = url.pathname.match(/^\/task\/([a-f0-9]+)$/);
  if (req.method === "GET" && taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) {
      jsonResponse(res, 404, { error: "Task not found or expired" });
      return;
    }
    // Auto-extend TTL on access
    task.lastAccessed = Date.now();
    jsonResponse(res, 200, {
      id: task.id,
      status: task.status,
      message: task.message,
      result: task.result || null,
      ...(task.permissionRequest ? {
        permission_request: {
          request_id: task.permissionRequest.requestId,
          tool_name: task.permissionRequest.toolName,
          description: task.permissionRequest.description,
          input_preview: task.permissionRequest.inputPreview,
        },
      } : {}),
    });
    return;
  }

  // GET /tasks — list all tasks (for debugging)
  if (req.method === "GET" && url.pathname === "/tasks") {
    const list = Array.from(tasks.values()).map((t) => ({
      id: t.id,
      status: t.status,
      message: t.message.slice(0, 100),
      createdAt: new Date(t.createdAt).toISOString(),
    }));
    jsonResponse(res, 200, { tasks: list });
    return;
  }

  // GET /subscribe — SSE stream for client-only sessions
  if (req.method === "GET" && url.pathname === "/subscribe") {
    const senderId = url.searchParams.get("sender") || undefined;
    const clientIp = req.socket.remoteAddress;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");

    if (senderId) {
      registerMachine(senderId, "client", clientIp);
    }

    const subscriber: SSESubscriber = { res, senderId };
    sseSubscribers.add(subscriber);
    console.error(`claude-relay: SSE subscriber connected (sender=${senderId || "anonymous"}, ip=${clientIp}, total=${sseSubscribers.size})`);

    // Heartbeat to keep connection alive and track machine status
    const heartbeat = setInterval(() => {
      try {
        res.write(":heartbeat\n\n");
        if (senderId) registerMachine(senderId, "client", clientIp);
      } catch {
        clearInterval(heartbeat);
      }
    }, MACHINE_HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseSubscribers.delete(subscriber);
      console.error(`claude-relay: SSE subscriber disconnected (total=${sseSubscribers.size})`);
    });
    return;
  }

  // GET /machines — list registered machines
  if (req.method === "GET" && url.pathname === "/machines") {
    jsonResponse(res, 200, { machines: getMachineList() });
    return;
  }

  // POST /chat — send a chat message to a room
  if (req.method === "POST" && url.pathname === "/chat") {
    try {
      const body = await readBody(req);
      const { from, message, room, reply_to } = JSON.parse(body) as {
        from: string;
        message: string;
        room?: string;
        reply_to?: string;
      };

      if (!message?.trim()) {
        jsonResponse(res, 400, { error: "Empty message" });
        return;
      }

      const chatRoom = room || "general";
      const msg = addChatMessage(from, message, chatRoom, reply_to);

      // Push to local Claude Code session (if not from self)
      if (from !== SESSION_NAME) {
        const replyContext = reply_to ? ` (replying to ${reply_to})` : "";
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: `[${chatRoom}] ${from}: ${message}${replyContext}`,
            meta: { chat_id: msg.id, from, room: chatRoom, type: "chat", ...(reply_to ? { reply_to } : {}) },
          },
        });
      }

      // Broadcast to SSE subscribers
      broadcastChat(msg);

      // Notify observers
      broadcastToObservers({
        type: "chat",
        id: msg.id,
        from: from,
        message,
        room: chatRoom,
        replyTo: reply_to,
      });

      jsonResponse(res, 201, { id: msg.id });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: errorMessage });
    }
    return;
  }

  // GET /chat — get chat history for a room
  if (req.method === "GET" && url.pathname === "/chat") {
    const room = url.searchParams.get("room") || "general";
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    jsonResponse(res, 200, { room, messages: getChatHistory(room, limit) });
    return;
  }

  // POST /permission — respond to a permission request (from remote client)
  if (req.method === "POST" && url.pathname === "/permission") {
    try {
      const body = await readBody(req);
      const { request_id, allow } = JSON.parse(body) as { request_id: string; allow: boolean };

      const perm = pendingPermissions.get(request_id);
      if (!perm) {
        jsonResponse(res, 404, { error: `Permission request "${request_id}" not found` });
        return;
      }

      await server.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: request_id.toLowerCase(),
          behavior: allow ? "allow" : "deny",
        },
      });

      if (perm.taskId) {
        const task = tasks.get(perm.taskId);
        if (task) {
          task.status = "pending";
          task.permissionRequest = undefined;
        }
      }

      pendingPermissions.delete(request_id);
      console.error(`claude-relay: permission ${allow ? "granted" : "denied"} for ${perm.toolName} (${request_id}) via HTTP`);

      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: errorMessage });
    }
    return;
  }

  // GET /permissions — list pending permission requests
  if (req.method === "GET" && url.pathname === "/permissions") {
    const list = Array.from(pendingPermissions.values()).map((p) => ({
      request_id: p.requestId,
      tool_name: p.toolName,
      description: p.description,
      input_preview: p.inputPreview,
      task_id: p.taskId,
      received_at: new Date(p.receivedAt).toISOString(),
    }));
    jsonResponse(res, 200, { permissions: list });
    return;
  }

  // GET /observe — SSE firehose of all events (for visualization UI)
  if (req.method === "GET" && url.pathname === "/observe") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(":ok\n\n");

    const observer: Observer = { res };
    observers.add(observer);
    console.error(`claude-relay: observer connected (total=${observers.size})`);

    req.on("close", () => {
      observers.delete(observer);
      console.error(`claude-relay: observer disconnected (total=${observers.size})`);
    });
    return;
  }

  // GET /history — full event history across all rooms and tasks (for initial load)
  if (req.method === "GET" && url.pathname === "/history") {
    const allChats = chatMessages.map((m) => ({
      type: "chat" as const,
      ...m,
      timestamp: m.createdAt,
    }));
    const allTasks = Array.from(tasks.values()).map((t) => ({
      type: t.status === "pending" ? "task_created" as const : "task_completed" as const,
      id: t.id,
      message: t.message,
      sender: t.sender,
      to: t.to,
      result: t.result,
      status: t.status,
      timestamp: t.createdAt,
    }));
    const all = [...allChats, ...allTasks].sort((a, b) => a.timestamp - b.timestamp);
    jsonResponse(res, 200, { events: all, machines: getMachineList() });
    return;
  }

  // POST /machines/heartbeat — client heartbeat
  if (req.method === "POST" && url.pathname === "/machines/heartbeat") {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body) as { name: string };
      const clientIp = req.socket.remoteAddress;
      registerMachine(name, "client", clientIp);
      jsonResponse(res, 200, { ok: true });
    } catch {
      jsonResponse(res, 400, { error: "Invalid heartbeat payload" });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
});

// ── Startup ────────────────────────────────────────────────────────

// ── SSE Client (for client-only mode) ─────────────────────────────

function subscribeToSSE(): void {
  const sseUrl = `${RELAY_URL}/subscribe?sender=${SESSION_NAME}`;
  console.error(`claude-relay: subscribing to SSE at ${sseUrl}`);

  const sseHeaders: Record<string, string> = {};
  if (RELAY_TOKEN) sseHeaders["Authorization"] = `Bearer ${RELAY_TOKEN}`;

  fetch(sseUrl, { headers: sseHeaders }).then(async (res) => {
    if (!res.ok || !res.body) {
      console.error(`claude-relay: SSE connection failed (${res.status})`);
      setTimeout(subscribeToSSE, 5000); // retry
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6)) as {
            type?: string;
            task_id?: string;
            message: string;
            sender?: string;
            // chat fields
            id?: string;
            from?: string;
            room?: string;
            reply_to?: string;
          };

          if (data.type === "chat") {
            // Chat message — push as channel notification
            const replyContext = data.reply_to ? ` (replying to ${data.reply_to})` : "";
            await server.notification({
              method: "notifications/claude/channel",
              params: {
                content: `[${data.room || "general"}] ${data.from}: ${data.message}${replyContext}`,
                meta: {
                  chat_id: data.id,
                  from: data.from,
                  room: data.room,
                  type: "chat",
                  ...(data.reply_to ? { reply_to: data.reply_to } : {}),
                },
              },
            });
            console.error(`claude-relay: SSE → chat from ${data.from} in ${data.room}`);
          } else {
            // Task message — push as channel notification
            await server.notification({
              method: "notifications/claude/channel",
              params: {
                content: data.message,
                meta: {
                  task_id: data.task_id,
                  ...(data.sender ? { sender: data.sender } : {}),
                },
              },
            });
            console.error(`claude-relay: SSE → channel notification for task ${data.task_id}`);
          }
        } catch (err) {
          // skip malformed lines
        }
      }
    }

    // Stream ended — reconnect
    console.error("claude-relay: SSE stream ended, reconnecting...");
    setTimeout(subscribeToSSE, 2000);
  }).catch((err) => {
    console.error(`claude-relay: SSE connection error: ${err instanceof Error ? err.message : String(err)}`);
    setTimeout(subscribeToSSE, 5000);
  });
}

async function main(): Promise<void> {
  let isHost = false;

  // Start HTTP server (graceful if port already taken by another instance)
  await new Promise<void>((resolve) => {
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `claude-relay: port ${HTTP_PORT} already in use. Operating in client-only mode with SSE subscription.`
        );
        isHost = false;
      } else {
        console.error("HTTP server error:", err);
      }
      resolve();
    });
    httpServer.listen(HTTP_PORT, RELAY_BIND, () => {
      console.error(`claude-relay HTTP server listening on http://${RELAY_BIND}:${HTTP_PORT} (session: ${SESSION_NAME})`);
      if (RELAY_TOKEN) {
        console.error("claude-relay: token auth ENABLED");
      } else {
        console.error("claude-relay: token auth DISABLED (set RELAY_TOKEN to enable)");
      }
      isHost = true;
      registerMachine(SESSION_NAME, "host", RELAY_BIND);
      resolve();
    });
  });

  // Connect MCP over stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("claude-relay MCP channel connected via stdio");

  // Subscribe to SSE if: client-only mode, OR RELAY_URL points to a remote host
  const relayIsRemote = !RELAY_URL.includes("127.0.0.1") && !RELAY_URL.includes("localhost");
  if (!isHost || relayIsRemote) {
    console.error(`claude-relay: subscribing to SSE (isHost=${isHost}, relayIsRemote=${relayIsRemote})`);
    subscribeToSSE();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
