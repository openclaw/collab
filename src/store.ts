import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { initialDocument, type Document } from "./model.js";
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
      if (doc.markdown.length > 200000)
        throw new Error("Document exceeds the 200,000-character limit.");
      doc.version++;
      doc.updatedAt = new Date().toISOString();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = this.filename(key),
        temporary = destination + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(doc), { mode: 0o600 });
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
