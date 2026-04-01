/**
 * Room registry with per-agent ACL for the claude-relay.
 * Pure in-memory module — no I/O dependencies.
 */

export interface Permission {
  read: boolean;
  write: boolean;
  history: boolean;
}

export interface RoomACLEntry {
  agentId: string;
  permission: Permission;
}

export interface RoomConfig {
  id: string;
  name: string;
  createdBy?: string;
  defaultPermission?: Permission;
  acl?: RoomACLEntry[];
}

export interface Room {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string;
  defaultPermission: Permission;
  acl: Map<string, Permission>;
}

export const OPEN_PERMISSION: Permission = { read: true, write: true, history: true };
export const READ_ONLY: Permission = { read: true, write: false, history: false };
export const READ_HISTORY: Permission = { read: true, write: false, history: true };
export const WRITE_ONLY: Permission = { read: false, write: true, history: false };

const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  create(config: RoomConfig): Room {
    const id = config.id;
    if (!ROOM_ID_RE.test(id)) {
      throw new Error(`Invalid room ID "${id}": must be lowercase alphanumeric/dashes, 1-63 chars`);
    }
    if (this.rooms.has(id)) {
      throw new Error(`Room "${id}" already exists`);
    }
    const room: Room = {
      id,
      name: config.name,
      createdAt: Date.now(),
      createdBy: config.createdBy || "system",
      defaultPermission: config.defaultPermission || OPEN_PERMISSION,
      acl: new Map(),
    };
    if (config.acl) {
      for (const entry of config.acl) {
        room.acl.set(entry.agentId, entry.permission);
      }
    }
    this.rooms.set(id, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  list(): Room[] {
    return Array.from(this.rooms.values());
  }

  ensureRoom(id: string): Room {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    return this.create({ id, name: id });
  }

  setAgentPermission(roomId: string, agentId: string, permission: Permission): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);
    room.acl.set(agentId, permission);
  }

  removeAgentPermission(roomId: string, agentId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);
    room.acl.delete(agentId);
  }

  setDefaultPermission(roomId: string, permission: Permission): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Room "${roomId}" not found`);
    room.defaultPermission = permission;
  }

  delete(roomId: string): boolean {
    return this.rooms.delete(roomId);
  }

  private resolve(roomId: string, agentId: string): Permission {
    const room = this.rooms.get(roomId);
    if (!room) return OPEN_PERMISSION; // unknown room = open (backward compat)
    return room.acl.get(agentId) || room.defaultPermission;
  }

  canRead(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).read;
  }

  canWrite(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).write;
  }

  canAccessHistory(roomId: string, agentId: string): boolean {
    return this.resolve(roomId, agentId).history;
  }

  getReadableAgents(roomId: string, connectedAgents: string[]): string[] {
    return connectedAgents.filter((a) => this.canRead(roomId, a));
  }

  serialize(room: Room): Record<string, unknown> {
    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      createdBy: room.createdBy,
      defaultPermission: room.defaultPermission,
      acl: Array.from(room.acl.entries()).map(([agentId, permission]) => ({
        agentId,
        permission,
      })),
    };
  }
}

/**
 * Extract @mentions from a message. Returns agent names without the @ prefix, lowercased.
 * Handles: start of string, after whitespace, after punctuation (comma, colon, etc.)
 * Case-insensitive: @Researcher -> "researcher" to match senderId conventions.
 */
export function extractMentions(message: string): string[] {
  const matches = message.match(/(?:^|[\s,;:!?()])@([\w-]+)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.replace(/.*@/, "").toLowerCase()))];
}
