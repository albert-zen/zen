import { readFile } from "node:fs/promises";

import {
  type MarketplaceCatalogSnapshot,
  validateMarketplaceCatalog,
} from "../marketplace.js";

export * from "../marketplace.js";

export interface MarketplaceCatalogTransport {
  load(): Promise<unknown>;
}

/** Read-only package metadata; plugin lifecycle remains owned by the Catalog. */
export class MarketplaceCatalogService {
  readonly #transport: MarketplaceCatalogTransport;

  constructor(transport: MarketplaceCatalogTransport) {
    this.#transport = transport;
  }

  async load(): Promise<MarketplaceCatalogSnapshot> {
    return validateMarketplaceCatalog(await this.#transport.load());
  }
}

export class JsonFileMarketplaceCatalogTransport implements MarketplaceCatalogTransport {
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<unknown> {
    return JSON.parse(await readFile(this.#file, "utf8")) as unknown;
  }
}
