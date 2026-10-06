/** Mount the dsh-link delegation tool in each fixture Agent's scope with
 * model selection enabled — the default `tool-subagent` mounts the tool
 * without `modelSelectionSettings: true`, so the test owns its own copy.
 */

import type { Context } from '@deepseek-ai/cordis'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import type { Config } from '@deepseek-ai/dsh-tool-subagent'

export const name = 'scoped-tool-subagent'
export const inject = ['agents', 'subagentModelSelection']

/**
 * Install the configured delegation tool before a published Agent starts its loop.
 * @param ctx - fixture Host context carrying Agent lifecycle events.
 * @param config - delegation-tool configuration forwarded into each Agent scope.
 */
export function apply(ctx: Context, config: Config): void {
  const install = (agent: NonNullable<Context['agent']>): void => {
    agent.ctx.plugin(ToolSubagent, {
      provider: config.provider,
      modelSelectionSettings: true,
      ...(config.toolName === undefined ? {} : { toolName: config.toolName }),
      ...(config.enableRunInBackground === undefined
        ? {}
        : { enableRunInBackground: config.enableRunInBackground }),
      ...(config.backgroundMode === undefined ? {} : { backgroundMode: config.backgroundMode }),
      ...(config.agentOptions === undefined ? {} : { agentOptions: config.agentOptions }),
      ...(config.persona === undefined ? {} : { persona: config.persona }),
      ...(config.toolFilter === undefined ? {} : { toolFilter: config.toolFilter }),
      ...(config.maxDepth === undefined ? {} : { maxDepth: config.maxDepth }),
    })
  }
  ctx.on('agent/created', ({ agent }) => { install(agent) })
  for (const agent of ctx.agents.list()) install(agent)
}
