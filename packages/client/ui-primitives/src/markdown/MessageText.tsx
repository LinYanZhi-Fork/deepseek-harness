// MessageText is the literal-text primitive for user and steering content; assistant output uses MarkdownText.

import css from './MessageText.module.css'

import type { JSX } from 'react'

export function MessageText({ text }: { text: string }): JSX.Element {
  return <div className={css.text}>{text}</div>
}
