import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(10000);

export type SeatEvent =
  | { type: 'seat'; show_id: string; seat_id: string; status: 'available' | 'held' | 'confirmed'; user_id?: number; at: string }
  | { type: 'reservation'; show_id: string; reservation_id: string; user_id: number; seats: string[]; outcome: 'confirmed' | 'cancelled'; at: string };

export function publish(ev: SeatEvent): void {
  bus.emit(ev.show_id, ev);
}

export function subscribe(show_id: string, listener: (ev: SeatEvent) => void): () => void {
  bus.on(show_id, listener);
  return () => bus.off(show_id, listener);
}
