import { createOpenAI } from "@ai-sdk/openai"
import { streamText } from "ai"
import { describe, expect, test } from "bun:test"

const failed = {
  type: "response.failed",
  sequence_number: 2,
  response: {
    id: "resp_failed",
    error: {
      code: "server_error",
      message: "The model failed while processing the response. Request ID: test-response-id",
    },
    incomplete_details: null,
    usage: null,
  },
}

describe("OpenAI Responses stream errors", () => {
  test("emits response.failed as an error event", async () => {
    const model = createOpenAI({
      apiKey: "test-key",
      fetch: Object.assign(
        async () =>
          new Response(`data: ${JSON.stringify(failed)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect() {} },
      ),
    }).responses("gpt-test")
    const parts = []

    for await (const part of streamText({ model, prompt: "hello", maxRetries: 0, onError: () => {} }).fullStream)
      parts.push(part)

    expect(parts.find((part) => part.type === "error")?.error).toMatchObject({
      type: "response.failed",
      response: { error: failed.response.error },
    })
  })
})
