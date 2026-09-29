/**
 * Jest global setup — runs once before all test suites in this project.
 * Suppresses high-volume console.log lines emitted by SchedulingEngine
 * while keeping console.warn and console.error visible.
 */
const originalLog = console.log;

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const msg = String(args[0] ?? '').trimStart();
    // Pass through anything that isn't scheduler verbose noise.
    const isNoise =
      msg.startsWith('Scheduling job') ||
      msg.startsWith('[SchedulingEngine]') ||
      msg.startsWith('[CpSat]') ||
      msg.startsWith('No available slot') ||
      msg.startsWith('Placed ') ||
      msg.startsWith('Generated ');
    if (!isNoise) originalLog(...args);
  });
});

afterAll(() => {
  jest.restoreAllMocks();
});
