import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev route-status badge (bottom-left) sat on top of the Studio nav button,
  // hiding it. Disable it — compile/runtime errors still surface via the overlay.
  devIndicators: false,
  // Proxy API calls to the FastAPI backend in development
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
