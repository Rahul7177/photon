import { describe, expect, it } from "vitest";
import { toGeminiFunctionDeclaration } from "./geminiProvider";

describe("Gemini function declaration mapping", () => {
  it("uses parametersJsonSchema and preserves rich JSON Schema", () => {
    const schema = {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
        },
        options: {
          type: "object",
          properties: {
            recursive: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
      required: ["files"],
      additionalProperties: false,
    };

    const declaration = toGeminiFunctionDeclaration({
      function: {
        name: "search_files",
        description: "Search files",
        parameters: schema,
      },
    });

    expect(declaration).toEqual({
      name: "search_files",
      description: "Search files",
      parametersJsonSchema: schema,
    });
    expect("parameters" in declaration).toBe(false);
  });
});
