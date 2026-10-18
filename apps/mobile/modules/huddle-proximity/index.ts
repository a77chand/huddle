// Re-export the native module. On web, it will be resolved to HuddleProximityModule.web.ts
// and on native platforms to HuddleProximityModule.ts
export { default } from './src/HuddleProximityModule';
export * from './src/HuddleProximity.types';
