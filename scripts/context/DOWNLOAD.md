# Download historical CSVs from Football-Data.co.uk
#
# EPL (E0):
# curl -L -o /mnt/user/appdata/goalscout/data/historical/england/2024_25.csv \
#   "https://www.football-data.co.uk/mmz4281/2425/E0.csv"
#
# URL pattern: https://www.football-data.co.uk/mmz4281/{YAYA}/{DIV}.csv
# Where YAYA = season year digits e.g. 2425 for 2024-25, 2324 for 2023-24
# And DIV = E0 (EPL), E1 (Championship), D1 (Bundesliga), SP1 (La Liga),
#           I1 (Serie A), F1 (Ligue 1), N1 (Eredivisie)
#
# Always create the target directory first:
# mkdir -p /mnt/user/appdata/goalscout/data/historical/{league}/
#
# Note: data/ is in .gitignore — CSVs are never committed to the repo.
