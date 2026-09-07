'use strict';
module.exports = function enableMicrophone(config) {
  let headers = 0;
  const updated = config.replace(/^(\s*add_header\s+Permissions-Policy\s+)(["'])([^\r\n]*?)\2(\s*(?:always\s*)?;)/gm,
    (line, prefix, quote, policy, suffix) => {
      if (!/microphone\s*=\s*\((?:self)?\)/.test(policy)) return line;
      headers++;
      return prefix + quote + policy.replace(/microphone\s*=\s*\(\)/g, 'microphone=(self)') + quote + suffix;
    });
  if (!headers) throw new Error('No recognized Permissions-Policy microphone directive found; review the live configuration manually');
  return updated;
};
