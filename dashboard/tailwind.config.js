/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'poly-green': '#00D26A',
        'poly-red': '#FF4444',
        'poly-blue': '#2962FF',
      },
    },
  },
  plugins: [],
}
