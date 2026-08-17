import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'selector',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      backgroundColor: {
        'custom-hover': 'var(--tw-hover-bg-color)',
      },
      dropShadow: {
        '3xl': '0px 5px 45px rgba(0, 0, 0, 0.8)',
      },
      backgroundImage: {
        'gradient-wrapper-dark':
          'radial-gradient(circle at bottom left, #000000, #010101 20%, #030303 40%, #080808 60%, #121212 80%, #1a1a1a 100%, #252525)',
        'gradient-wrapper':
          'radial-gradient(circle at -20% 120%, #ffffff, #f6f6f6, #eeeeee, #e5e5e5, #dcdcdc, #d4d4d4, #cbcbcb, #c3c3c3)',
        'cycling-colors':
          'linear-gradient(to right, #8b53fb, #673ab7, #ff5722, #ff9800, #ffc107, #03a9f4, #8b53fb)',
      },
      fontFamily: {
        whiterabt: 'var(--font-whiterabt)',
      },
      colors: {
        darktext: '#080808',
        lighttext: '#e8e8e8',
        lighttext2: '#c8c8c8',
        main: '#8B53FB',
        secondary: '#533197',
        tertiary: '#361d66',
        bglight: '#d4d4d4',
        bgdark: '#0a0a0a',
        darkgray: '#2b2b2b',
        darkergray: '#1c1c1c',
        darkestgray: '#0d0d0d',
        'cycling-colors':
          'linear-gradient(to right, #8b53fb, #673ab7, #ff5722, #ff9800, #ffc107, #03a9f4, #8b53fb)',
      },
      typography: {
        DEFAULT: {
          css: {
            h1: {
              color: '#8B53FB',
            },
            h2: {
              color: '#8B53FB',
            },
            h3: {
              color: '#8B53FB',
            },
            h4: {
              color: '#8B53FB',
            },
            h5: {
              color: '#8B53FB',
            },
            h6: {
              color: '#8B53FB',
            },
          },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};
export default config;
