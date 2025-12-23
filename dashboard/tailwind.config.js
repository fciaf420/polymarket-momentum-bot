/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Terminal base colors
        'term-bg': '#0a0a0a',
        'term-panel': '#111111',
        'term-border': '#1a1a1a',

        // Neon accents
        'cyber-cyan': '#00ffff',
        'matrix-green': '#00ff41',
        'hot-pink': '#ff0066',
        'amber': '#ffb000',
        'neon-purple': '#bf00ff',

        // Text colors
        'term-text': '#e0e0e0',
        'term-muted': '#666666',
        'term-dim': '#444444',

        // Legacy poly colors (keeping for compatibility)
        'poly-green': '#00D26A',
        'poly-red': '#FF4444',
        'poly-blue': '#2962FF',
      },
      fontFamily: {
        'mono': ['JetBrains Mono', 'Fira Code', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'glow-cyan': '0 0 10px #00ffff40, 0 0 20px #00ffff20, 0 0 30px #00ffff10',
        'glow-green': '0 0 10px #00ff4140, 0 0 20px #00ff4120',
        'glow-pink': '0 0 10px #ff006640, 0 0 20px #ff006620',
        'glow-amber': '0 0 10px #ffb00040, 0 0 20px #ffb00020',
        'glow-sm-cyan': '0 0 5px #00ffff60',
        'glow-sm-green': '0 0 5px #00ff4160',
        'glow-sm-pink': '0 0 5px #ff006660',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'blink': 'blink 1s step-end infinite',
        'scan': 'scan 8s linear infinite',
        'flicker': 'flicker 0.15s infinite',
        'typing': 'typing 0.5s steps(20) forwards',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'scan': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'flicker': {
          '0%': { opacity: '0.97' },
          '50%': { opacity: '1' },
          '100%': { opacity: '0.98' },
        },
        'typing': {
          'from': { width: '0' },
          'to': { width: '100%' },
        },
      },
    },
  },
  plugins: [],
}
