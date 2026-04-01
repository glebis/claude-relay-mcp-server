export interface PermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  receivedAt: number;
  taskId?: string;
}

export function createPermissionStore() {
  const pending = new Map<string, PermissionRequest>();

  return {
    add(req: PermissionRequest): void {
      pending.set(req.requestId, req);
    },

    get(requestId: string): PermissionRequest | undefined {
      return pending.get(requestId);
    },

    remove(requestId: string): boolean {
      return pending.delete(requestId);
    },

    list(): PermissionRequest[] {
      return Array.from(pending.values());
    },

    findByTask(taskId: string): PermissionRequest | undefined {
      for (const req of pending.values()) {
        if (req.taskId === taskId) return req;
      }
      return undefined;
    },
  };
}
