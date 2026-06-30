output "task_role_arn" {
  description = "ARN del task role. Mettilo nel trust dei ruoli dadaguard-readonly (var.dadaguard_task_role_arn) per restringere la trust al task esatto invece che all'account-root."
  value       = aws_iam_role.task.arn
}

output "service_name" {
  description = "Nome del servizio ECS creato."
  value       = aws_ecs_service.this.name
}

output "security_group_id" {
  description = "ID del security group (solo egress) del task."
  value       = aws_security_group.this.id
}
