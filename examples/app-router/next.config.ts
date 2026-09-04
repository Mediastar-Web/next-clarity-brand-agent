import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The package ships TypeScript sources, so Next has to compile them.
  transpilePackages: ['next-clarity-brand-agent'],
};

export default nextConfig;
