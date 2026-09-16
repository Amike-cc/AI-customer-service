/** Jest renderer test configuration */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/tests/renderer'],
  testMatch: ['**/*.test.tsx', '**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/renderer/setup.ts'],
  moduleFileExtensions: ['tsx', 'ts', 'js', 'json'],
  moduleNameMapper: {
    '\\.module\\.css$': 'identity-obj-proxy',
    '\\.css$': 'identity-obj-proxy',
    '^@/(.*)$': '<rootDir>/src/$1',
    'lucide-react': '<rootDir>/tests/renderer/__mocks__/lucide-react.tsx',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};