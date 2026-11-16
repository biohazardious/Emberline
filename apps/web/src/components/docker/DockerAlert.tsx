export interface ErrorDetails {
  message: string;
  output: string | null;
}

/** An error in `role="alert"`, with the failed command's output (untrusted) as plain text. */
export function DockerAlert({ error }: { error: ErrorDetails | string }) {
  const { message, output } = typeof error === 'string' ? { message: error, output: null } : error;
  return (
    <div className="banner banner-error docker-ux-alert" role="alert">
      <p>{message}</p>
      {output && <pre className="docker-ux-output mono">{output}</pre>}
    </div>
  );
}
