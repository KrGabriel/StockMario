/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef6ff",
          100: "#d9eaff",
          200: "#bcd8ff",
          300: "#8ebeff",
          400: "#599bfc",
          500: "#337af6",
          600: "#1d5deb",
          700: "#1749d8",
          800: "#193caf",
          900: "#1a3789",
          950: "#142552",
        },
      },
    },
  },
  plugins: [],
};
