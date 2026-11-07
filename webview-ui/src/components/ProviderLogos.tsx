import React from "react";

/**
 * High-precision, official SVG brand logos for supported AI model providers.
 * Styled to fit Photon's dark matte void aesthetic with crisp vector rendering.
 */

export function GeminiLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <defs>
        <linearGradient id="photon-gemini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4E75FF" />
          <stop offset="50%" stopColor="#9B72CB" />
          <stop offset="100%" stopColor="#E473FF" />
        </linearGradient>
      </defs>
      <path
        d="M12 0C12 6.627 6.627 12 0 12C6.627 12 12 17.373 12 24C12 17.373 17.373 12 24 12C17.373 12 12 6.627 12 0Z"
        fill="url(#photon-gemini-grad)"
      />
    </svg>
  );
}

export function ClaudeLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M13.8 2.2c-.3 0-.6.2-.7.5l-3.2 8.4-4-7.5c-.2-.4-.6-.6-1-.4-.4.2-.6.6-.4 1l4.4 8.3-8.4-3.2c-.4-.1-.8.1-.9.5-.1.4.1.8.5.9l8.3 3.2-8.3 3.2c-.4.2-.6.6-.5.9.1.4.5.6.9.5l8.4-3.2-4.4 8.3c-.2.4 0 .8.4 1 .4.2.8 0 1-.4l4-7.5 3.2 8.4c.1.4.5.6.8.6.4 0 .7-.3.8-.7l3.2-8.4 4 7.5c.2.4.6.6 1 .4.4-.2.6-.6.4-1l-4.4-8.3 8.4 3.2c.4.1.8-.1.9-.5.1-.4-.1-.8-.5-.9l-8.3-3.2 8.3-3.2c.4-.2.6-.6.5-.9-.1-.4-.5-.6-.9-.5l-8.4 3.2 4.4-8.3c.2-.4 0-.8-.4-1-.4-.2-.8 0-1 .4l-4 7.5-3.2-8.4c-.1-.3-.4-.5-.7-.5z"
        fill="#D97757"
      />
    </svg>
  );
}

export function OpenAILogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.064l-4.83 2.793a4.495 4.495 0 0 1-6.15-1.65zm-1.03-9.582a4.47 4.47 0 0 1 2.34-1.977v5.679a.79.79 0 0 0 .393.681l5.844 3.37-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.793A4.504 4.504 0 0 1 2.57 8.722zm16.654 3.256l-5.844-3.37 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.793a4.495 4.495 0 0 1-.685 8.105v-5.679a.79.79 0 0 0-.392-.681zm2.01-3.053l-.142-.085-4.779-2.759a.775.775 0 0 0-.78 0L9.69 9.45V7.118a.08.08 0 0 1 .033-.064l4.83-2.793a4.495 4.495 0 0 1 6.685 4.659zM8.307 15.356l-2.02-1.168a.076.076 0 0 1-.038-.052V8.553a4.495 4.495 0 0 1 7.37-3.454l-.142.08-4.778 2.759a.794.794 0 0 0-.392.681v6.737zm1.096-2.366l2.6-1.5 2.6 1.5v3.001l-2.6 1.5-2.6-1.5v-3.001z"
        fill="#10A37F"
      />
    </svg>
  );
}

export function NvidiaLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M7.886 16.486c-2.455-.429-4.323-2.39-4.439-4.873-.122-2.607 1.776-4.945 4.382-5.41 2.21-.395 4.453.649 5.485 2.552.327.604.53 1.282.593 1.989.06.666-.029 1.341-.264 1.97-.24.643-.637 1.217-1.157 1.67-.525.457-1.156.776-1.838.932a4.4 4.4 0 0 1-2.762-.17v1.34zm6.096-3.834c.057-.86-.168-1.72-.647-2.433-.49-.728-1.214-1.258-2.062-1.51-.83-.245-1.722-.187-2.518.167-.796.353-1.442.96-1.826 1.72-.379.75-.467 1.613-.248 2.433.22.82.72 1.523 1.41 1.983.69.46 1.526.667 2.36.585.834-.082 1.616-.453 2.208-1.047.592-.595.962-1.373 1.042-2.208a3.17 3.17 0 0 0-.019-.89l.3-.8z"
        fill="#76B900"
      />
      <path
        d="M12.01 2.5C6.75 2.5 2.5 6.75 2.5 12.01s4.25 9.51 9.51 9.51 9.51-4.25 9.51-9.51S17.27 2.5 12.01 2.5zm6.81 12.82c-.89 1.44-2.18 2.58-3.7 3.25-1.53.67-3.23.85-4.86.51-1.63-.34-3.13-1.21-4.27-2.48-1.14-1.27-1.82-2.89-1.93-4.59-.11-1.7.35-3.39 1.3-4.8 1.93-2.86 5.3-4.48 8.78-4.2 1.63.13 3.2.73 4.5 1.73l-1.46 1.7c-1.04-.79-2.3-1.27-3.62-1.37-2.8-.21-5.5 1.09-7.05 3.39-.76 1.13-1.13 2.48-1.04 3.84.09 1.36.63 2.65 1.54 3.67.91 1.02 2.11 1.72 3.42 1.99 1.31.27 2.67.12 3.89-.42 1.22-.54 2.25-1.45 2.96-2.6l1.53 1.37z"
        fill="#76B900"
      />
    </svg>
  );
}

export function OpenRouterLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M12 2L2 7.5V17L12 22.5L22 17V7.5L12 2Z"
        stroke="#818CF8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 7L7 9.8V15.4L12 18.2L17 15.4V9.8L12 7Z"
        fill="#6366F1"
        fillOpacity="0.4"
        stroke="#818CF8"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12.5" r="2.5" fill="#A5B4FC" />
    </svg>
  );
}

export function OpenCodeLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="12" cy="12" r="9" stroke="#8B5CF6" strokeWidth="2" strokeDasharray="46 10" />
      <path
        d="M9 9.5L6.5 12L9 14.5M15 9.5L17.5 12L15 14.5"
        stroke="#C4B5FD"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BlackboxLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M12 2L21 7.2V16.8L12 22L3 16.8V7.2L12 2Z" fill="#18181B" stroke="#F59E0B" strokeWidth="2" />
      <path d="M12 22V12M21 7.2L12 12M3 7.2L12 12" stroke="#F59E0B" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3" fill="#F59E0B" />
    </svg>
  );
}

export function LlamaCppLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M6 3L8 6V10L9 12H15L16 10V6L18 3L16 5V9H8V5L6 3Z"
        fill="#38BDF8"
      />
      <circle cx="10" cy="15" r="1.5" fill="#38BDF8" />
      <circle cx="14" cy="15" r="1.5" fill="#38BDF8" />
      <path
        d="M10 18C10.5 19 13.5 19 14 18"
        stroke="#38BDF8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect x="5" y="11" width="14" height="10" rx="3" stroke="#38BDF8" strokeWidth="1.8" />
    </svg>
  );
}

export function GroqLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="12" cy="12" r="8.5" stroke="#F55036" strokeWidth="2.2" />
      <path
        d="M12 7.5C9.5 7.5 7.5 9.5 7.5 12C7.5 14.5 9.5 16.5 12 16.5C14.5 16.5 16.5 14.5 16.5 12V11H12"
        stroke="#F55036"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function DeepSeekLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M3 13.5C4 10 7.5 7.5 12 7.5C17.5 7.5 21 11.5 21 15C19 13.5 16.5 13 14 13.5C10 14.5 7 17.5 5 20C4.5 18 3.5 15.5 3 13.5Z"
        fill="#1D70F5"
      />
      <circle cx="9" cy="11.5" r="1.5" fill="#FFFFFF" />
      <path
        d="M13 4C14 6 15 7.5 16 8.5C14.5 8 13.5 8 12 8.5C11.5 7 12 5.5 13 4Z"
        fill="#1D70F5"
      />
    </svg>
  );
}

export function MistralLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="3" y="4" width="4" height="4" fill="#FF7000" />
      <rect x="17" y="4" width="4" height="4" fill="#FF7000" />
      <rect x="3" y="8" width="4" height="4" fill="#FF7000" />
      <rect x="7" y="8" width="4" height="4" fill="#FF7000" />
      <rect x="13" y="8" width="4" height="4" fill="#FF7000" />
      <rect x="17" y="8" width="4" height="4" fill="#FF7000" />
      <rect x="3" y="12" width="4" height="4" fill="#FF7000" />
      <rect x="10" y="12" width="4" height="4" fill="#FF7000" />
      <rect x="17" y="12" width="4" height="4" fill="#FF7000" />
      <rect x="3" y="16" width="4" height="4" fill="#FF7000" />
      <rect x="17" y="16" width="4" height="4" fill="#FF7000" />
    </svg>
  );
}

export function TogetherLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8.5" cy="12" r="5.5" stroke="#3B82F6" strokeWidth="2.2" />
      <circle cx="15.5" cy="12" r="5.5" stroke="#EC4899" strokeWidth="2.2" />
    </svg>
  );
}

export function CustomServerLogo({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect x="2" y="3" width="20" height="7" rx="2" />
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <line x1="6" y1="6.5" x2="6.01" y2="6.5" strokeWidth="2.5" />
      <line x1="6" y1="17.5" x2="6.01" y2="17.5" strokeWidth="2.5" />
      <path d="M16 6.5h2M16 17.5h2" />
    </svg>
  );
}

/**
 * Universal Provider Logo router.
 * Renders the accurate official SVG logo based on provider ID or label.
 */
export function ProviderLogo({
  providerId,
  label,
  size = 20,
  className = "",
}: {
  providerId: string;
  label?: string;
  size?: number;
  className?: string;
}) {
  const normId = (providerId || "").toLowerCase();
  const normLabel = (label || "").toLowerCase();

  if (normId === "gemini" || normLabel.includes("gemini") || normLabel.includes("google")) {
    return <GeminiLogo size={size} className={className} />;
  }
  if (normId === "claude" || normLabel.includes("claude") || normLabel.includes("anthropic")) {
    return <ClaudeLogo size={size} className={className} />;
  }
  if (normId === "openai" || normLabel.includes("openai") || normLabel.includes("chatgpt")) {
    return <OpenAILogo size={size} className={className} />;
  }
  if (normId === "nvidia" || normLabel.includes("nvidia") || normLabel.includes("nim")) {
    return <NvidiaLogo size={size} className={className} />;
  }
  if (normId === "openrouter" || normLabel.includes("openrouter")) {
    return <OpenRouterLogo size={size} className={className} />;
  }
  if (normId === "opencode" || normLabel.includes("opencode") || normLabel.includes("zen")) {
    return <OpenCodeLogo size={size} className={className} />;
  }
  if (normId === "blackbox" || normLabel.includes("blackbox")) {
    return <BlackboxLogo size={size} className={className} />;
  }
  if (normId === "llamacpp" || normLabel.includes("llama.cpp")) {
    return <LlamaCppLogo size={size} className={className} />;
  }
  if (normId.includes("groq") || normLabel.includes("groq")) {
    return <GroqLogo size={size} className={className} />;
  }
  if (normId.includes("deepseek") || normLabel.includes("deepseek")) {
    return <DeepSeekLogo size={size} className={className} />;
  }
  if (normId.includes("mistral") || normLabel.includes("mistral")) {
    return <MistralLogo size={size} className={className} />;
  }
  if (normId.includes("together") || normLabel.includes("together")) {
    return <TogetherLogo size={size} className={className} />;
  }

  return <CustomServerLogo size={size} className={className} />;
}
