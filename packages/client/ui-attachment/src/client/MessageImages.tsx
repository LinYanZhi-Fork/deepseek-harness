import type { MessageImagesProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

import type { JSX } from 'react'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, t }: MessageImagesProps): JSX.Element {
  return <ImageGallery images={images} load={loadImage} align={align} labels={messageImageLabels(t)} />
}
