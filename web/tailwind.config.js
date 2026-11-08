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
      // One motion language: quick to start, long soft landing. Only opacity/transform are animated.
      transitionTimingFunction: { DEFAULT: "cubic-bezier(.22,1,.36,1)", "out-expo": "cubic-bezier(.16,1,.3,1)" },
      transitionDuration: { DEFAULT: "220ms" },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        rise: { from: { opacity: 0, transform: "translateY(12px)" }, to: { opacity: 1, transform: "none" } },
        fade: { from: { opacity: 0 }, to: { opacity: 1 } },
        pop: { from: { opacity: 0, transform: "translateY(6px) scale(.98)" }, to: { opacity: 1, transform: "none" } },
        bulb: { "0%,100%": { opacity: 0.35 }, "50%": { opacity: 1 } },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        rise: "rise .65s cubic-bezier(.16,1,.3,1) both",
        fade: "fade .45s cubic-bezier(.22,1,.36,1) both",
        page: "fade .35s cubic-bezier(.22,1,.36,1) both", // opacity only: a transform would break fixed children
        pop: "pop .35s cubic-bezier(.16,1,.3,1) both",
        bulb: "bulb 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
