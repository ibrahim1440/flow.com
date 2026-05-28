import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  async redirects() {
    return [
      { source: "/dashboard.html",        destination: "/dashboard",        permanent: false },
      { source: "/dashboard/:path*.html", destination: "/dashboard/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
