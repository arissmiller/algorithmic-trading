/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "surface-0": "#02060b",
        surface: "#02060b",
        "surface-1": "#07131f",
        "surface-2": "#0c1b2c",
        "surface-3": "#13263d",
        border: "#234364",
        "text-primary": "#ecf7ff",
        "text-secondary": "#98b8d5",
        buy: "#35ff9d",
        sell: "#ff5f7f",
        accent: "#46d7ff",
      },
    },
  },
  plugins: [],
};
