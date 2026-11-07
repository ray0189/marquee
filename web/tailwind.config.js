/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0a0c", 900: "#111114", 800: "#18181c", 700: "#212126", 600: "#2c2c33", 500: "#4b4b55" },
        bone: { DEFAULT: "#f4f4f6", dim: "#b3b3bd", mute: "#787884" },
        amber: { DEFAULT: "#9b8cff", deep: "#7b6cf0", glow: "#b9aeff" },
        ember: "#ff6b5b",
        moss: "#6fd39a",
      },
      fontFamily: {
        display: ['"Inter Variable"', "system-ui", "sans-serif"],
        sans: ['"Inter Variable"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        lift: "0 18px 50px -12px rgba(0,0,0,.8)",
        glow: "0 0 0 1px rgba(255,255,255,.35), 0 14px 40px -10px rgba(0,0,0,.9)",
      },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        rise: { from: { opacity: 0, transform: "translateY(10px)" }, to: { opacity: 1, transform: "none" } },
        fade: { from: { opacity: 0 }, to: { opacity: 1 } },
        bulb: { "0%,100%": { opacity: 0.35 }, "50%": { opacity: 1 } },
      },
      animation: { shimmer: "shimmer 1.6s infinite", rise: "rise .5s ease both", fade: "fade .6s ease both", bulb: "bulb 2.4s ease-in-out infinite" },
    },
  },
  plugins: [],
};
