import { createInterface } from "node:readline";

export class ConsoleChannel {
  constructor({ input = process.stdin, output = process.stdout, prompt = "> " } = {}) {
    this.input = input;
    this.output = output;
    this.prompt = prompt;
    this.interface = null;
  }

  async start(handler) {
    if (typeof handler !== "function") throw new TypeError("console_channel_requires_handler");
    this.interface = createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.input.isTTY)
    });

    this.output.write("Digital employee is ready. Type a question or /quit.\n");
    if (this.input.isTTY) this.interface.setPrompt(this.prompt);
    this.interface.prompt();

    for await (const line of this.interface) {
      const question = line.trim();
      if (!question) {
        this.interface.prompt();
        continue;
      }
      if (question === "/quit" || question === "/exit") break;

      const result = await handler({
        id: `console-${Date.now()}`,
        threadId: "console",
        text: question,
        channel: "console"
      });
      this.output.write(`${result.answer || result.escalation?.message || "No answer"}\n`);
      for (const citation of result.citations || []) {
        this.output.write(`- ${citation.title || citation.id}: ${citation.uri || "approved source"}\n`);
      }
      this.interface.prompt();
    }
    await this.stop();
  }

  async stop() {
    this.interface?.close();
    this.interface = null;
  }
}
