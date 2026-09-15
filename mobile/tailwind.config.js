/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./App.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}"
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border, 215 17% 15%))',
        input: 'hsl(var(--input, 215 17% 15%))',
        ring: 'hsl(var(--ring, 146 90% 50%))',
        background: 'hsl(var(--background, 0 0% 2%))',
        foreground: 'hsl(var(--foreground, 0 0% 100%))',
        primary: {
          DEFAULT: 'hsl(var(--primary, 146 90% 50%))',
          foreground: 'hsl(var(--primary-foreground, 0 0% 2%))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary, 215 21% 11%))',
          foreground: 'hsl(var(--secondary-foreground, 0 0% 100%))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive, 348 100% 58%))',
          foreground: 'hsl(var(--destructive-foreground, 0 0% 100%))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted, 215 21% 11%))',
          foreground: 'hsl(var(--muted-foreground, 215 10% 58%))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent, 146 62% 9%))',
          foreground: 'hsl(var(--accent-foreground, 146 90% 50%))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover, 215 28% 7%))',
          foreground: 'hsl(var(--popover-foreground, 0 0% 100%))',
        },
        card: {
          DEFAULT: 'hsl(var(--card, 215 28% 7%))',
          foreground: 'hsl(var(--card-foreground, 0 0% 100%))',
        },

        /* Semantic Cyber Palette */
        obsidian: '#050505',
        surface: {
          DEFAULT: '#0D1117',
          hover: '#161B22',
          border: '#1F242C',
        },
        neon: {
          DEFAULT: '#0DF272',
          glow: '#00FF66',
          dim: '#092615',
          border: 'rgba(13, 242, 114, 0.25)',
        },
        cyber: {
          cyan: '#00F0FF',
          crimson: '#FF2A55',
          amber: '#FFB800',
        },
      },
      fontFamily: {
        mono: ['Menlo', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
};
