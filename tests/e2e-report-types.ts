export type Profile = 'PUBLIC' | 'BILLING' | 'INTERNAL' | 'SYSTEM';

export type CommandExpectation = {
  exitCode: number;
  stdoutContains?: string[];
  stdoutExact?: string;
  stderrContains?: string[];
  stderrExact?: string;
};

export type CommandCaseRecord = {
  suite: string;
  test: string;
  profile: Profile;
  command: string;
  expected: CommandExpectation;
  actual: {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
  status: 'passed' | 'failed';
  failures: string[];
  createdAt: string;
};
