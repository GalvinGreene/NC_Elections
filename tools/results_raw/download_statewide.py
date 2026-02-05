import requests

url = "https://s3.amazonaws.com/dl.ncsbe.gov/ENRS/2024_11_05/results_precinct_sort/STATEWIDE_PRECINCT_SORT.txt"
output_file = "STATEWIDE_PRECINCT_SORT.txt"

print(f"Downloading from {url} …")

response = requests.get(url, stream=True)
response.raise_for_status()

with open(output_file, "wb") as f:
    for chunk in response.iter_content(chunk_size=8192):
        f.write(chunk)

print(f"Saved {output_file}")