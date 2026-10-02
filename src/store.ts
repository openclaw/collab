import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { initialDocument, MAX_DOCUMENT_CHARS, type Document } from "./model.js";
/** Serializes each document's read-modify-write; failed writes never poison the queue. */
export class DocumentStore {
  private tails = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string) {}
  private filename(key: string) {
    return path.join(this.directory, createHash("sha256").update(key).digest("hex") + ".json");
  }
  private async load(key: string): Promise<Document> {
    try {
      const doc = JSON.parse(await readFile(this.filename(key), "utf8")) as Document;
      if (
        doc.sessionKey !== key ||
        typeof doc.markdown !== "string" ||
        !Number.isInteger(doc.revision)
      )
        throw new Error("Invalid saved Collab document");
      return doc;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialDocument(key);
      throw error;
    }
  }
  async read(key: string) {
    await this.tails.get(key);
    return this.load(key);
  }
  async mutate(key: string, edit: (doc: Document) => void): Promise<Document> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const pending = previous.then(async () => {
      const doc = await this.load(key);
      edit(doc);
      if (doc.markdown.length > MAX_DOCUMENT_CHARS)
        throw new Error("Document exceeds the 60,000-character limit.");
      doc.version++;
      doc.updatedAt = new Date().toISOString();
      // Budget before publication: the host's feature transport is bounded to
      // 64 KiB per string, 4096 JSON nodes, and 256 KiB serialized bytes.
      // A rejected history entry must never make the saved document unreadable.
      const serialized = JSON.stringify(doc);
      const countNodes = (value: unknown): number =>
        1 +
        (value && typeof value === "object"
          ? Object.values(value).reduce<number>((n, v) => n + countNodes(v), 0)
          : 0);
      if (Buffer.byteLength(serialized, "utf8") > 240000 || countNodes(doc) > 3800) {
        throw new Error(
          "This document's review history has reached its size limit. Export the draft and continue in a new session.",
        );
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.filename(key),
        temporary = destination + "." + randomUUID() + ".tmp";
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, destination);
      return doc;
    });
    const tail = pending.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return pending;
  }
}
