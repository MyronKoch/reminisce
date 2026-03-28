/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Liquid Glass Design System - Apple-native aesthetic
        'apple': {
          'blue': '#0A84FF',
          'green': '#30D158',
          'red': '#FF453A',
          'yellow': '#FF9F0A',
          'purple': '#BF5AF2',
          'cyan': '#64D2FF',
          'orange': '#FF9500',
        },
        // Alias for backwards compatibility
        'reminisce-blue': '#0A84FF',
        'reminisce-purple': '#BF5AF2',
        'reminisce-green': '#30D158',
        // Glass surfaces
        'glass': {
          'bg': 'rgba(28, 28, 30, 0.8)',
          'border': 'rgba(255, 255, 255, 0.1)',
        },
      },
      backgroundColor: {
        'primary': '#000000',
        'secondary': 'rgba(28, 28, 30, 0.8)',
        'tertiary': 'rgba(44, 44, 46, 0.8)',
      },
      textColor: {
        'primary': 'rgba(255, 255, 255, 0.95)',
        'secondary': 'rgba(255, 255, 255, 0.7)',
        'tertiary': 'rgba(255, 255, 255, 0.5)',
      },
      borderColor: {
        'glass': 'rgba(255, 255, 255, 0.1)',
      },
      fontFamily: {
        'sans': ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'SF Pro Text', 'system-ui', 'sans-serif'],
        'mono': ['SF Mono', 'ui-monospace', 'monospace'],
      },
      backdropBlur: {
        'glass': '20px',
      },
    },
  },
  plugins: [],
}
