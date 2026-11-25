class JiraChecker {
  /**
   * Check if commit message contains valid JIRA ticket reference
   * @param {string} message - The commit message
   * @param {object} config - Configuration for JIRA checking
   * @returns {object} - Result with valid flag, message, and suggestion
   */
  static check (message, config = {}) {
    if (!config.required) {
      return {
        valid: true,
        message: 'JIRA check disabled'
      }
    }

    // Default JIRA ticket pattern (e.g., ABC-123, PROJ-456)
    const defaultPattern = /[A-Z]+-\d+/
    const pattern = config.pattern ? new RegExp(config.pattern) : defaultPattern

    const hasJiraTicket = pattern.test(message)

    if (!hasJiraTicket) {
      return {
        valid: false,
        message: `JIRA ticket reference not found in commit message: ${message}`,
        suggestion: config.suggestion || 'Include JIRA ticket reference (e.g., ABC-123) in your commit message',
        details: 'Commit messages should reference the related JIRA ticket'
      }
    }

    return {
      valid: true,
      message: 'JIRA ticket reference found in commit message'
    }
  }

  /**
   * Extract JIRA ticket IDs from commit message
   * @param {string} message - The commit message
   * @param {object} config - Configuration for JIRA checking
   * @returns {array} - Array of JIRA ticket IDs
   */
  static extractTicketIds (message, config = {}) {
    const defaultPattern = /[A-Z]+-\d+/g
    const pattern = config.pattern ? new RegExp(config.pattern, 'g') : defaultPattern

    return message.match(pattern) || []
  }

  /**
   * Check if JIRA ticket ID follows project naming conventions
   * @param {string} ticketId - The JIRA ticket ID
   * @param {object} config - Configuration for project checking
   * @returns {object} - Result with valid flag, message, and suggestion
   */
  static checkProjectFormat (ticketId, config = {}) {
    const allowedProjects = config.allowedProjects || []

    if (allowedProjects.length === 0) {
      return {
        valid: true,
        message: 'No project restrictions configured'
      }
    }

    const projectKey = ticketId.split('-')[0]

    if (!allowedProjects.includes(projectKey)) {
      return {
        valid: false,
        message: `JIRA project key "${projectKey}" is not in allowed list: ${allowedProjects.join(', ')}`,
        suggestion: `Use tickets from allowed projects: ${allowedProjects.join(', ')}`
      }
    }

    return {
      valid: true,
      message: `JIRA project key "${projectKey}" is valid`
    }
  }

  /**
   * Check if commit message has JIRA ticket in the right position
   * @param {string} message - The commit message
   * @param {object} config - Configuration for position checking
   * @returns {object} - Result with valid flag, message, and suggestion
   */
  static checkTicketPosition (message, config = {}) {
    const position = config.position || 'anywhere' // 'start', 'end', 'anywhere'
    const ticketIds = this.extractTicketIds(message, config)

    if (ticketIds.length === 0) {
      return {
        valid: false,
        message: 'No JIRA ticket found in commit message',
        suggestion: 'Add JIRA ticket reference to commit message'
      }
    }

    const firstTicket = ticketIds[0]
    const ticketIndex = message.indexOf(firstTicket)

    switch (position) {
      case 'start':
        if (ticketIndex !== 0) {
          return {
            valid: false,
            message: 'JIRA ticket must be at the beginning of commit message',
            suggestion: 'Move JIRA ticket to the start of commit message'
          }
        }
        break

      case 'end': {
        const lastIndex = message.lastIndexOf(firstTicket)
        if (lastIndex + firstTicket.length !== message.length) {
          return {
            valid: false,
            message: 'JIRA ticket must be at the end of commit message',
            suggestion: 'Move JIRA ticket to the end of commit message'
          }
        }
        break
      }

      case 'anywhere':
        // Valid anywhere
        break

      default:
        return {
          valid: false,
          message: `Unknown position requirement: ${position}`,
          suggestion: 'Check configuration for valid position values'
        }
    }

    return {
      valid: true,
      message: `JIRA ticket is in the correct position (${position})`
    }
  }

  /**
   * Check for multiple JIRA tickets in commit message
   * @param {string} message - The commit message
   * @param {object} config - Configuration for multiple tickets
   * @returns {object} - Result with valid flag, message, and suggestion
   */
  static checkMultipleTickets (message, config = {}) {
    const ticketIds = this.extractTicketIds(message, config)
    const allowMultiple = config.allowMultiple !== false // Default to true
    const maxTickets = config.maxTickets || Infinity

    if (!allowMultiple && ticketIds.length > 1) {
      return {
        valid: false,
        message: `Multiple JIRA tickets found (${ticketIds.length}), but only one is allowed`,
        suggestion: 'Reference only one JIRA ticket per commit'
      }
    }

    if (ticketIds.length > maxTickets) {
      return {
        valid: false,
        message: `Too many JIRA tickets found (${ticketIds.length}), maximum allowed: ${maxTickets}`,
        suggestion: `Reference at most ${maxTickets} JIRA ticket(s) per commit`
      }
    }

    // Check for duplicate tickets
    const uniqueTickets = new Set(ticketIds)
    if (uniqueTickets.size !== ticketIds.length) {
      return {
        valid: false,
        message: 'Duplicate JIRA tickets found in commit message',
        suggestion: 'Remove duplicate JIRA ticket references'
      }
    }

    return {
      valid: true,
      message: `Found ${ticketIds.length} valid JIRA ticket(s)`
    }
  }

  /**
   * Validate JIRA ticket format
   * @param {string} ticketId - The JIRA ticket ID
   * @param {object} config - Configuration for format validation
   * @returns {object} - Result with valid flag, message, and suggestion
   */
  static validateTicketFormat (ticketId, config = {}) {
    // Check basic format (PROJECT-NUMBER)
    const basicFormat = /^[A-Z]+-\d+$/
    if (!basicFormat.test(ticketId)) {
      return {
        valid: false,
        message: `Invalid JIRA ticket format: ${ticketId}`,
        suggestion: 'Use format: PROJECT-123 (uppercase project key, hyphen, number)'
      }
    }

    const [projectKey, ticketNumber] = ticketId.split('-')

    // Check project key length
    const minProjectLength = config.minProjectLength || 2
    const maxProjectLength = config.maxProjectLength || 10

    if (projectKey.length < minProjectLength || projectKey.length > maxProjectLength) {
      return {
        valid: false,
        message: `Project key length invalid: ${projectKey} (${projectKey.length} chars)`,
        suggestion: `Project key should be ${minProjectLength}-${maxProjectLength} characters`
      }
    }

    // Check ticket number
    const ticketNum = parseInt(ticketNumber, 10)
    const minTicketNumber = config.minTicketNumber || 1
    const maxTicketNumber = config.maxTicketNumber || 999999

    if (ticketNum < minTicketNumber || ticketNum > maxTicketNumber) {
      return {
        valid: false,
        message: `Ticket number out of range: ${ticketNumber}`,
        suggestion: `Ticket number should be between ${minTicketNumber} and ${maxTicketNumber}`
      }
    }

    return {
      valid: true,
      message: `JIRA ticket format is valid: ${ticketId}`
    }
  }

  /**
   * Get JIRA ticket URL
   * @param {string} ticketId - The JIRA ticket ID
   * @param {object} config - Configuration with JIRA base URL
   * @returns {string} - Full JIRA ticket URL
   */
  static getTicketUrl (ticketId, config = {}) {
    const baseUrl = config.baseUrl || 'https://your-jira-instance.atlassian.net'
    return `${baseUrl}/browse/${ticketId}`
  }

  /**
   * Check if JIRA integration is properly configured
   * @param {object} config - JIRA configuration
   * @returns {object} - Configuration validation result
   */
  static validateConfig (config) {
    const errors = []

    if (config.pattern) {
      try {
        new RegExp(config.pattern) // eslint-disable-line no-new
      } catch (error) {
        errors.push(`Invalid JIRA pattern regex: ${error.message}`)
      }
    }

    if (config.position && !['start', 'end', 'anywhere'].includes(config.position)) {
      errors.push(`Invalid position value: ${config.position}. Must be 'start', 'end', or 'anywhere'`)
    }

    if (config.maxTickets && (typeof config.maxTickets !== 'number' || config.maxTickets < 1)) {
      errors.push('maxTickets must be a positive number')
    }

    if (config.baseUrl && !config.baseUrl.startsWith('http')) {
      errors.push('baseUrl must be a valid HTTP/HTTPS URL')
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }
}

module.exports = JiraChecker
