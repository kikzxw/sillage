export type Account = { id: string; name: string; identity: string }
export type Space = { id: string; name: string; owner: string }
export type Room = { id: string; name: string; kind: 'channel' | 'direct'; space: string | null; owner: string; members: number; joined: number; welcome: string | null; packageId: string | null }
export type EventRecord = { id: string; seq: number; sender: string; at: number; data: string }
export type PackageRecord = { id: string; data: string }
export type Friendship = { sender: string; recipient: string; status: 'pending' | 'accepted' | 'declined' }
export type Directory = { accounts: Account[]; spaces: Space[]; rooms: Room[]; packages: number; friendships: Friendship[]; onlineFriends: string[] }
export type Payload =
  | { kind: 'text'; from: string; text: string }
  | { kind: 'file'; from: string; name: string; id: string; key: string; iv: string; size: number }
export type Message = { id: string; at: number; payload: Payload }
