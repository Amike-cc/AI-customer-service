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
    global: {
      branches: 60,
      functions: 65,
      lines: 65,
      statements: 65,
    },
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};
