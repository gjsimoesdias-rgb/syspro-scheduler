/**
 * Type declaration for express-ntlm (no @types package available).
 */
declare module 'express-ntlm' {
  import type { Request, Response, NextFunction } from 'express';

  interface NtlmOptions {
    /** NetBIOS domain name, e.g. "MYDOMAIN" */
    domain?: string;
    /** LDAP URL of the domain controller, e.g. "ldap://dc.mydomain.local" */
    domaincontroller?: string;
    /** Optional debug logger */
    debug?: (...args: unknown[]) => void;
    /** TLS options when using ldaps:// */
    tlsOptions?: Record<string, unknown>;
    /** Called when a bad request is received */
    badrequest?: (req: Request, res: Response, next: NextFunction) => void;
  }

  function ntlm(
    options?: NtlmOptions
  ): (req: Request, res: Response, next: NextFunction) => void;

  export = ntlm;
}

// Augment Express Request with the ntlm property populated after auth
declare global {
  namespace Express {
    interface Request {
      ntlm?: {
        /** Windows username (no domain prefix) */
        UserName: string;
        /** NetBIOS domain name */
        DomainName: string;
        /** Workstation name */
        Workstation: string;
      };
    }
  }
}
