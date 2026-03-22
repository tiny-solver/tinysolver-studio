export function AppIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      className={className}
    >
      <defs>
        <linearGradient id="ai-code" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#e0e7ff" />
          <stop offset="100%" stopColor="#c7d2fe" />
        </linearGradient>
        <linearGradient id="ai-b1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4081" />
          <stop offset="100%" stopColor="#e91e63" />
        </linearGradient>
        <linearGradient id="ai-b2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffeb3b" />
          <stop offset="100%" stopColor="#fdd835" />
        </linearGradient>
        <linearGradient id="ai-b3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#29b6f6" />
          <stop offset="100%" stopColor="#03a9f4" />
        </linearGradient>
      </defs>
      <rect
        x="16"
        y="16"
        width="480"
        height="480"
        rx="96"
        ry="96"
        fill="#1a1a2e"
      />
      <polyline
        points="190,180 120,240 190,300"
        fill="none"
        stroke="url(#ai-code)"
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points="322,180 392,240 322,300"
        fill="none"
        stroke="url(#ai-code)"
        strokeWidth="32"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="280"
        y1="160"
        x2="232"
        y2="320"
        stroke="url(#ai-code)"
        strokeWidth="28"
        strokeLinecap="round"
        opacity="0.7"
      />
      <circle cx="176" cy="396" r="28" fill="url(#ai-b1)" opacity="0.95" />
      <circle cx="256" cy="396" r="28" fill="url(#ai-b2)" opacity="0.95" />
      <circle cx="336" cy="396" r="28" fill="url(#ai-b3)" opacity="0.95" />
    </svg>
  )
}
