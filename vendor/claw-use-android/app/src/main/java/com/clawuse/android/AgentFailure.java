package com.clawuse.android;

/** A stable protocol error, never prose that the server has to parse. */
final class AgentFailure extends Exception {
    final String code;

    AgentFailure(String code) {
        super(code);
        this.code = code;
    }

    AgentFailure(String code, Throwable cause) {
        super(code, cause);
        this.code = code;
    }
}
