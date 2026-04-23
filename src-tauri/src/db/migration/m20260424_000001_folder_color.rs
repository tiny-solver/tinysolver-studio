use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .add_column(
                        ColumnDef::new(Folder::Color)
                            .string()
                            .not_null()
                            .default("#22c55e"),
                    )
                    .to_owned(),
            )
            .await?;

        // Backfill existing rows with a palette color chosen by (id - 1) mod N,
        // so existing workspaces get visually distinct swatches after migration.
        let conn = manager.get_connection();
        let sql = "UPDATE folder SET color = CASE ((id - 1) % 9) \
            WHEN 0 THEN '#ef4444' \
            WHEN 1 THEN '#f97316' \
            WHEN 2 THEN '#eab308' \
            WHEN 3 THEN '#84cc16' \
            WHEN 4 THEN '#22c55e' \
            WHEN 5 THEN '#06b6d4' \
            WHEN 6 THEN '#8b5cf6' \
            WHEN 7 THEN '#d946ef' \
            WHEN 8 THEN '#ec4899' \
            END";
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_string()))
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Folder::Table)
                    .drop_column(Folder::Color)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Folder {
    Table,
    Color,
}
