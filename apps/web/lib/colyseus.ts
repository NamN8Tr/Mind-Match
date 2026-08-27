import { Client } from "@colyseus/sdk";

let client: Client | undefined;

/** One shared Colyseus client per browser tab, created lazily on first use. */
export function getColyseusClient(): Client {
  if (!client) {
    const url = process.env["NEXT_PUBLIC_COLYSEUS_URL"] ?? "ws://localhost:4001";
    client = new Client(url);
  }
  return client;
}
