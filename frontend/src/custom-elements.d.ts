import type React from 'react'

type MoqWatchProps = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
  url?: string
  name?: string
  paused?: string | boolean
  muted?: string | boolean
  volume?: string | number
  latency?: string
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'moq-watch': MoqWatchProps
      'moq-watch-ui': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }

  namespace React {
    namespace JSX {
      interface IntrinsicElements {
        'moq-watch': MoqWatchProps
        'moq-watch-ui': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
      }
    }
  }
}

export {}

