/// The one realtime surface of the API. REST stays the transport for all
/// writes and initial loads; these events are push-only.
export const SOCKET_PATH = '/api/socket.io';

export const REALTIME_EVENTS = {
  CHAT_REQUEST_CREATED: 'chat.request.created',
  CHAT_THREAD_CLAIMED: 'chat.thread.claimed',
  CHAT_MESSAGE_NEW: 'chat.message.new',
  CHAT_THREAD_CLOSED: 'chat.thread.closed',
  CHAT_UNREAD_UPDATED: 'chat.unread.updated',
  NOTIFICATION_NEW: 'notification.new',
  NOTIFICATION_UNREAD_UPDATED: 'notification.unread.updated',
} as const;

export type RealtimeEvent =
  (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

/// Every authenticated socket joins their personal room; all personal pushes
/// (notifications, chat messages, unread counts) target it. Multi-device safe:
/// N sockets of one user share the room.
export const userRoom = (userId: string) => `user:${userId}`;

/// Joined only by verified professionals (COUNSELLOR | PSYCHOLOGIST |
/// SUPPORT_STAFF) of an ACTIVE school — the chat request-pool audience.
export const schoolProfessionalsRoom = (schoolId: string) =>
  `school-professionals:${schoolId}`;
