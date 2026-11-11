resource "aws_budgets_budget" "account" {
  count = var.budget_notification_email == "" ? 0 : 1

  name         = "agora-monthly"
  budget_type  = "COST"
  limit_amount = "30"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = [
      { type = "ACTUAL", threshold = "20" },
      { type = "ACTUAL", threshold = "24" },
      { type = "FORECASTED", threshold = "28" },
    ]

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = "ABSOLUTE_VALUE"
      notification_type          = notification.value.type
      subscriber_email_addresses = [var.budget_notification_email]
    }
  }
}
