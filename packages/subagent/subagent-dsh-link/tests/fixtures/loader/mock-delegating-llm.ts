/**
 * Scripted model that issues exactly one `subagent_run` tool call against the
 * configured dsh-link provider and replies with the tool result. The driver
 * framework inspects the resulting tool result text through the session log.
 */

import type { LlmScriptedTurn } from '@deepseek-ai/dsh-loader-smoke'

export const turns: LlmScriptedTurn[] = [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        tool: {
          name: 'subagent_run',
          input: { provider: 'dsh-link', task: 'echo from scripted model' },
        },
      },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'delegated' }],
  },
]
