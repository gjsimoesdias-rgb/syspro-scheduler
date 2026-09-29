/** Jest configuration for the backend. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/server.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  verbose: true,
  // Prevent open handles (e.g. pino's async transport) from blocking exit.
  forceExit: true,
  // Global setup file — suppresses SchedulingEngine console.log noise.
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.ts'],
  silent: false,
};
