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
        "text-primary": "#f2fbff",
        "text-secondary": "#b8d0e5",
        buy: "#35ff9d",
        sell: "#ff5f7f",
        accent: "#46d7ff",
      },
      fontSize: {
        xs: ["0.8125rem", { lineHeight: "1.45" }],
        sm: ["0.9375rem", { lineHeight: "1.5" }],
      },
    },
  },
  plugins: [],
};
