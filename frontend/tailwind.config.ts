import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './features/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg:       '#080D14',
        surface:  '#0D1520',
        elevated: '#111C2E',
        border:   '#1A2840',
        cyan: {
          DEFAULT: '#00D4FF',
          dim:     '#00D4FF1A',
          glow:    '#00D4FF44',
        },
        orange: {
          DEFAULT: '#FF6B1A',
          dim:     '#FF6B1A1A',
          glow:    '#FF6B1A44',
        },
        green: {
          DEFAULT: '#00E5A0',
          dim:     '#00E5A01A',
        },
        red: {
          DEFAULT: '#FF3B5C',
          dim:     '#FF3B5C1A',
        },
        amber: {
          DEFAULT: '#F59E0B',
          dim:     '#F59E0B1A',
        },
        violet: {
          DEFAULT: '#A78BFA',
          dim:     '#A78BFA1A',
        },
        text: {
          primary: '#E8F4FF',
          muted:   '#4A6080',
          dim:     '#2A3F5A',
        },
      },
      boxShadow: {
        'neon-cyan':   '0 0 8px #00D4FF44, 0 0 20px #00D4FF18',
        'neon-orange': '0 0 8px #FF6B1A44, 0 0 20px #FF6B1A18',
        'neon-green':  '0 0 8px #00E5A044, 0 0 20px #00E5A018',
        'neon-red':    '0 0 8px #FF3B5C44',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow':  'spin 2s linear infinite',
      },
    },
  },
  plugins: [],
}

export default config
