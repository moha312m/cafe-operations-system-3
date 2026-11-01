import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.CASHIER_TOUCH_BUILD === "1" ? ".next-touch" : ".next",
};

export default nextConfig;
