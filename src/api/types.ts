// Records of the Raindrop REST API (https://developer.raindrop.io), only the
// fields tinydrop reads or writes.

export type RaindropType = "link" | "article" | "image" | "video" | "document" | "audio";

/** Collection IDs with a fixed meaning. */
export const ALL_COLLECTION = 0;
export const UNSORTED_COLLECTION = -1;
export const TRASH_COLLECTION = -99;

export interface Highlight {
  _id: string;
  text: string;
  note?: string;
  color?: string;
  created?: string;
}

export interface Raindrop {
  _id: number;
  link: string;
  title: string;
  excerpt?: string;
  note?: string;
  type?: RaindropType;
  cover?: string;
  tags?: string[];
  important?: boolean;
  broken?: boolean;
  created?: string;
  lastUpdate?: string;
  domain?: string;
  collection?: { $id: number };
  collectionId?: number;
  highlights?: Highlight[];
}

/** The fields a create or an update sends. */
export interface RaindropPatch {
  link?: string;
  title?: string;
  excerpt?: string;
  note?: string;
  tags?: string[];
  important?: boolean;
  collection?: { $id: number };
  pleaseParse?: Record<string, never>;
}

export interface Collection {
  _id: number;
  title: string;
  parent?: { $id: number };
  sort?: number;
  count?: number;
  cover?: string[];
}

export interface Tag {
  _id: string;
  count: number;
}

export interface UserGroup {
  title: string;
  hidden?: boolean;
  sort?: number;
  collections: number[];
}

export interface User {
  _id: number;
  fullName?: string;
  name?: string;
  email?: string;
  pro?: boolean;
  groups?: UserGroup[];
}

export interface ItemsReply<T> {
  result: boolean;
  items: T[];
  count?: number;
}

export interface ItemReply<T> {
  result: boolean;
  item: T;
}

/** The reply of a bulk call: no per-ID detail. `modified` below the ID count means some IDs did not move. */
export interface BulkReply {
  result: boolean;
  matched?: number;
  modified?: number;
}

export interface UserReply {
  result: boolean;
  user: User;
}

/** The name the Account screen shows for a user. */
export function userName(user: User): string {
  return user.fullName || user.name || user.email || `User ${user._id}`;
}
