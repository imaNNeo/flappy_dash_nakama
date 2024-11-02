deployFromMain:
	git pull origin main
	cd data/modules/functions && make generateJS && cd ../../../
	docker compose restart && docker compose up -d
	echo "Deployed from main branch completed"

runLocally:
	cd data/modules/functions && make generateJS && cd ../../../
	docker compose restart && docker compose up