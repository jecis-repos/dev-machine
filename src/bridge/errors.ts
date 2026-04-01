export class BridgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeValidationError';
  }
}

export class BridgeDockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeDockerError';
  }
}

export class BridgeGithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeGithubError';
  }
}
