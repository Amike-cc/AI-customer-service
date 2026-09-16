/** Jest unit test configuration */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/types.ts',
    // 以下模块通过 chaos / e2e / integration 测试覆盖，不在单元测试覆盖率统计内
    '!src/shop/ShopSupervisor.ts',
    '!src/cache/ContextManager.ts',
    '!src/monitor/MetricsCollector.ts',
    '!src/monitor/notifiers/**',
    // 入口脚本，不含可单元测试的逻辑
    '!src/setup.ts',
    '!src/db/migrate.ts',
    '!src/backend.ts',
  ],
  coverageDirectory: 'coverage/unit',
  coverageThreshold: {
    // 单元测试覆盖主进程核心逻辑；跨模块路径由 renderer/chaos/e2e/integration
    // 测试覆盖。门槛按当前可重复基线设置，仍会阻止覆盖率明显回退。
    global: {
      branches: 45,
      functions: 65,
      lines: 60,
      statements: 60,
    },
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};
