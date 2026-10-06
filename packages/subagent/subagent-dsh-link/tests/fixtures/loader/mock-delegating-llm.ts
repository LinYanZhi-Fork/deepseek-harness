/**
 * Scripted parent model that issues exactly one `subagent` tool call against
 * the configured dsh-link provider and replies with the tool result text back
 * verbatim — so the dsh-link peer's reply reaches the parent session log for
 * the driving e2e to assert.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

class MockDelegatingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('max'), name: 'Maximum' }],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResultText = options.messages.at(-1)?.content
      .filter(block => block.type === 'tool-result')
      .flatMap(block => block.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('') ?? ''

    if (toolResultText.length === 0) {
      const args = JSON.stringify({
        description: 'route probe',
        prompt: 'echo from scripted model',
        provider: 'mock',
        model: 'mock-routed',
        reasoning_effort: 'max',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-delegate'), name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-delegate'), name: 'subagent', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const reply = `parent-saw:\n${toolResultText}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'mock-llm'
export const inject = ['llm']

/** Register the delegating mock adapter under the `mock` provider. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new MockDelegatingAdapter())
}
